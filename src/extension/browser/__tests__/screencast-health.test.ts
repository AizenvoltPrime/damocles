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

  it('does not restart before any start is recorded', () => {
    const h = new ScreencastHealth(THRESHOLD);
    expect(h.shouldRestart(10_000, true, true)).toBe(false);
  });
});
