import { describe, it, expect } from 'vitest';
import { ScreencastHealth } from '../screencast-health';

describe('ScreencastHealth', () => {
  const THRESHOLD = 100;

  it('does not restart while frames flow', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteFrame();
    h.noteFrame();
    // Well past the threshold, but frames arrived since the start.
    expect(h.shouldRestart(1000, true, true)).toBe(false);
  });

  it('does not restart on static page silence after a first frame', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteFrame();
    // No further frames for a long time; a static page legitimately goes quiet.
    expect(h.shouldRestart(10_000, true, true)).toBe(false);
  });

  it('restarts when a start is older than the threshold with zero frames', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    expect(h.shouldRestart(THRESHOLD, true, true)).toBe(false); // not strictly greater yet
    expect(h.shouldRestart(THRESHOLD + 1, true, true)).toBe(true);
  });

  it('restarts after an ack failure', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteFrame();
    expect(h.shouldRestart(20, true, true)).toBe(false);
    h.noteAckFailure();
    expect(h.shouldRestart(20, true, true)).toBe(true);
  });

  it('clears the pending ack failure on the next start', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteAckFailure();
    expect(h.shouldRestart(10, true, true)).toBe(true);
    h.noteStart(50);
    expect(h.shouldRestart(60, true, true)).toBe(false);
  });

  it('clears the pending ack failure when a frame arrives (stream recovered)', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteAckFailure();
    expect(h.shouldRestart(10, true, true)).toBe(true);
    // A frame after the failed ack proves Chromium is still emitting; the transient failure must
    // not keep forcing restarts.
    h.noteFrame();
    expect(h.shouldRestart(20, true, true)).toBe(false);
  });

  it('never restarts while hidden', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteAckFailure();
    // Hidden trumps every restart reason including a pending ack failure and a stale start.
    expect(h.shouldRestart(10_000, false, true)).toBe(false);
  });

  it('never restarts while disconnected', () => {
    const h = new ScreencastHealth(THRESHOLD);
    h.noteStart(0);
    h.noteAckFailure();
    expect(h.shouldRestart(10_000, true, false)).toBe(false);
  });

  it('does not restart before any stream is wanted', () => {
    const h = new ScreencastHealth(THRESHOLD);
    expect(h.shouldRestart(10_000, true, true)).toBe(false);
  });

  /**
   * THE WATCHDOG'S BLIND SPOT. The panel's `ready` message is the sole trigger for `screencast.start()`,
   * so a `ready` that never arrives means the CDP call is never made. With the clock armed by that call,
   * `startedAt` stayed null, `shouldRestart` returned false on every tick forever, and the panel sat on
   * "Waiting for browser frames…" with no recovery — while the watchdog reported healthy. Anchoring on
   * INTENT is what puts the never-happened steps inside the watchdog's view.
   */
  describe('intent-anchored clock', () => {
    it('detects a stall when the stream is WANTED but start() is never called', () => {
      const h = new ScreencastHealth(THRESHOLD);
      h.noteWanted(0);
      expect(h.shouldRestart(THRESHOLD, true, true)).toBe(false);
      expect(h.shouldRestart(THRESHOLD + 1, true, true)).toBe(true);
    });

    it('is idempotent while armed, so repeated visibility/ready cycles cannot push the deadline out', () => {
      const h = new ScreencastHealth(THRESHOLD);
      h.noteWanted(0);
      // A panel can flip visible and post `ready` several times for ONE stream. Re-arming on each would
      // reset the clock indefinitely and mask exactly the stall this exists to catch.
      h.noteWanted(50);
      h.noteWanted(90);
      expect(h.shouldRestart(THRESHOLD + 1, true, true)).toBe(true);
    });

    it('disarms when the stream is no longer wanted, so a hidden panel is never called stalled', () => {
      const h = new ScreencastHealth(THRESHOLD);
      h.noteWanted(0);
      h.noteStopped();
      expect(h.shouldRestart(10_000, true, true)).toBe(false);

      // POSITIVE CONTROL: re-arming after a stop works, so `noteStopped` disarmed rather than wedged.
      h.noteWanted(10_000);
      expect(h.shouldRestart(10_000 + THRESHOLD + 1, true, true)).toBe(true);
    });

    it('a frame arriving after intent clears the stall, even with no start() in between', () => {
      const h = new ScreencastHealth(THRESHOLD);
      h.noteWanted(0);
      h.noteFrame();
      expect(h.shouldRestart(10_000, true, true)).toBe(false);
    });

    it('a real start resets the clock, giving the restart a full window for its first frame', () => {
      const h = new ScreencastHealth(THRESHOLD);
      h.noteWanted(0);
      expect(h.shouldRestart(THRESHOLD + 1, true, true)).toBe(true);
      h.noteStart(THRESHOLD + 1);
      expect(h.shouldRestart(THRESHOLD + 2, true, true)).toBe(false);
      expect(h.shouldRestart(2 * THRESHOLD + 3, true, true)).toBe(true);
    });
  });
});
