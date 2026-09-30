/**
 * Pure policy for deciding when a screencast has stalled and should be restarted.
 *
 * This class holds NO timers, NO vscode, and NO CDP references so it stays fully unit
 * testable. The owning BrowserService feeds it lifecycle notifications (wanted, start, frame,
 * ack failure) and polls shouldRestart on a watchdog tick.
 *
 * THE CLOCK IS ANCHORED ON INTENT, NOT ON THE CDP CALL. `noteWanted` is what arms the stall
 * detector, and it fires the moment a panel decides it should be streaming — before, and
 * independently of, anything being sent to Chromium. Anchoring on the CDP call instead leaves
 * the watchdog structurally blind to every failure BEFORE it: the panel's `ready` message is
 * the sole trigger for `start()`, so a `ready` that never arrives means `start()` never runs,
 * `startedAt` stays null, `shouldRestart` returns false forever, and the watchdog reports
 * healthy on every tick while the panel sits on "Waiting for browser frames…" with no
 * recovery. A detector that can only see failures downstream of a call it assumes was made is
 * not a detector.
 *
 * Restart is warranted in exactly two situations while the panel is connected and visible:
 *   1. An acknowledgement failure is pending. A failed screencastFrameAck is the primary
 *      stuck stream signal because Chromium stops emitting frames after a few unacked ones.
 *      A subsequent frame proves the stream recovered, so noteFrame clears the pending flag.
 *   2. The stream has been wanted for longer than the stall threshold yet not a single frame
 *      has arrived since it was wanted (e.g. the very first frame never came, the start call
 *      failed, or the start was never made at all).
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

  /**
   * A panel now wants to stream. Arms the stall clock at the point of INTENT, so every step between
   * here and the first frame — including the steps that never happen — is inside the watchdog's view.
   *
   * Idempotent while a stream is already armed: visibility can flip and `ready` can arrive several
   * times for one stream, and re-arming on each would keep pushing the deadline out and mask a real
   * stall. Only {@link ScreencastHealth.noteStopped} disarms.
   */
  noteWanted(now: number = Date.now()): void {
    if (this.startedAt !== null) return;
    this.startedAt = now;
    this.framesSinceStart = 0;
    this.pendingAckFailure = false;
  }

  /** The stream was (re)started against Chromium. Resets the stall clock so a restart gets a full
   *  window to produce its first frame rather than inheriting the exhausted one. */
  noteStart(now: number = Date.now()): void {
    this.startedAt = now;
    this.framesSinceStart = 0;
    this.pendingAckFailure = false;
  }

  /** No stream is wanted any more (panel hidden, tab closed). Disarms the clock so a hidden panel is
   *  never reported as stalled. */
  noteStopped(): void {
    this.startedAt = null;
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

  /** Whether this stream has been armed long enough with no frame, or has a failed ack outstanding.
   *  `startedAt === null` means no stream is wanted, which is never a stall. */
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
