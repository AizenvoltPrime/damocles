/**
 * Pure policy for deciding when a screencast has stalled and should be restarted.
 *
 * This class holds NO timers, NO vscode, and NO CDP references so it stays fully unit
 * testable. The owning BrowserService feeds it lifecycle notifications (start, frame,
 * ack failure) and polls shouldRestart on a watchdog tick.
 *
 * Restart is warranted in exactly two situations while the panel is connected and visible:
 *   1. An acknowledgement failure is pending. A failed screencastFrameAck is the primary
 *      stuck stream signal because Chromium stops emitting frames after a few unacked ones.
 *      A subsequent frame proves the stream recovered, so noteFrame clears the pending flag.
 *   2. A start is older than the stall threshold yet not a single frame has arrived since
 *      that start (a start anchored stall, e.g. the very first frame never came).
 *
 * A static page that legitimately goes silent AFTER delivering at least one frame is NOT a
 * stall, so framesSinceStart > 0 always suppresses the start anchored branch.
 */
export class ScreencastHealth {
  private readonly startStallThresholdMs: number;
  private startedAt: number | null = null;
  private framesSinceStart = 0;
  private pendingAckFailure = false;

  constructor(startStallThresholdMs = 10_000) {
    this.startStallThresholdMs = startStallThresholdMs;
  }

  noteStart(now: number = Date.now()): void {
    this.startedAt = now;
    this.framesSinceStart = 0;
    this.pendingAckFailure = false;
  }

  noteFrame(): void {
    this.framesSinceStart++;
    this.pendingAckFailure = false;
  }

  noteAckFailure(): void {
    this.pendingAckFailure = true;
  }

  shouldRestart(now: number, visible: boolean, connected: boolean): boolean {
    if (!connected || !visible) return false;
    if (this.pendingAckFailure) return true;
    return (
      this.startedAt !== null &&
      now - this.startedAt > this.startStallThresholdMs &&
      this.framesSinceStart === 0
    );
  }
}
