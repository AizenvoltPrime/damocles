import type { Page } from 'patchright';
import type { ScreencastHealth } from './screencast-health';
import { log } from '../logger';

/** JPEG quality of the live screencast stream. */
export const STREAM_JPEG_QUALITY = 80;
/** JPEG quality of one-shot tool screenshots (lower — they are read by a model, not watched). */
export const TOOL_JPEG_QUALITY = 70;
/** Upper bound on the device scale factor sent to CDP; beyond 2x costs bandwidth for no visible gain. */
export const MAX_DEVICE_SCALE = 2;
/**
 * How long a pushed frame may stay unacked before the host acks it anyway.
 *
 * This is NOT the primary safety net — every stream-stopping edge releases the pending ack itself
 * (see {@link ScreencastController.releasePendingAck}). It exists only for a webview that is alive but
 * wedged (e.g. `createImageBitmap` throwing persistently), which would otherwise never post
 * `frameRendered` and would leave Chromium's in-flight count permanently short.
 */
export const FRAME_ACK_FALLBACK_MS = 1000;

/** How often the screencast watchdog polls every visible tab, and the unit its backoff counts in. */
const WATCHDOG_TICK_MS = 5_000;
/** Ceiling on the watchdog's exponential restart backoff (5s→10s→20s→40s→60s). */
const WATCHDOG_MAX_BACKOFF_MS = 60_000;

/**
 * The slice of a `PageEntry` the screencast owns. Structural rather than the full entry so this module
 * stays independent of the page registry, while still mutating the SAME objects the service holds —
 * the ack state machine's correctness depends on there being exactly one copy of these fields.
 */
export interface ScreencastEntry {
  page: Page;
  controller: {
    startScreencast(opts: {
      format: 'jpeg';
      quality: number;
      everyNthFrame: number;
      maxWidth: number;
      maxHeight: number;
    }): Promise<void>;
    stopScreencast(): Promise<void>;
    ackScreencastFrame(sessionId: number): Promise<void>;
  };
  panel: {
    visible: boolean;
    pushFrame(bytes: Buffer, deviceWidth: number, deviceHeight: number, frameId: number): void;
  };
  lastFrame: { bytes: Buffer; deviceWidth: number; deviceHeight: number } | null;
  pendingAck: { sessionId: number; frameId: number; timer: ReturnType<typeof setTimeout> } | null;
  nextFrameId: number;
  health: ScreencastHealth;
  watchdogFailureStreak: number;
  watchdogSkipTicks: number;
  ackRestartTimer: ReturnType<typeof setTimeout> | null;
  viewport: { width: number; height: number; dpr: number };
}

/**
 * Owns the live screencast: stream start, the per-frame ack backpressure state machine, and the
 * stall watchdog.
 *
 * The watchdog scans EVERY entry rather than a single "active" one, so its cross-entry suppliers are
 * injected: `entries` yields the live page registry and `isConnected` reports session state.
 */
export class ScreencastController {
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  private readonly entries: () => Iterable<ScreencastEntry>;
  private readonly isConnected: () => boolean;
  private readonly isRegistered: (entry: ScreencastEntry) => boolean;

  constructor(
    entries: () => Iterable<ScreencastEntry>,
    isConnected: () => boolean,
    isRegistered: (entry: ScreencastEntry) => boolean,
  ) {
    this.entries = entries;
    this.isConnected = isConnected;
    this.isRegistered = isRegistered;
  }

  options(entry: ScreencastEntry): {
    format: 'jpeg';
    quality: number;
    everyNthFrame: number;
    maxWidth: number;
    maxHeight: number;
  } {
    return {
      format: 'jpeg' as const,
      quality: STREAM_JPEG_QUALITY,
      everyNthFrame: 1,
      maxWidth: Math.round(entry.viewport.width * entry.viewport.dpr),
      maxHeight: Math.round(entry.viewport.height * entry.viewport.dpr),
    };
  }

  /**
   * Start (or restart) this entry's stream.
   *
   * REJECTS ON FAILURE. It previously caught and logged, which made the `.catch()` at every call site
   * unreachable — including `resizeEntry`, which awaits this and genuinely needs to know that the
   * resized stream never came back. A method whose failure is invisible to its callers forces each of
   * them to guess, and they all guessed the same wrong way.
   *
   * The stall detector is armed BEFORE the CDP call, so a rejected or timed-out send still leaves the
   * watchdog a start with no frames to retry against.
   */
  async start(entry: ScreencastEntry): Promise<void> {
    entry.health.noteStart();
    await entry.controller.startScreencast(this.options(entry));
  }

  /**
   * Settle this tab's outstanding screencast frame — the ONLY place `entry.pendingAck` is cleared.
   *
   * Chromium paces frame production by acks: it keeps a bounded in-flight count and stops emitting once
   * enough frames go unacked. So every path that abandons a pushed frame MUST come through here, or the
   * stream wedges permanently — including across a later stop/start, since the in-flight count survives.
   *
   * The field is nulled BEFORE the ack is issued, and that ordering is mandatory rather than tidy: it is
   * what makes a second ack of one `sessionId` structurally impossible. A slow decode whose
   * `frameRendered` lands after the fallback timer already fired finds nothing to release and no-ops.
   * Chromium's `frames_in_flight_` bookkeeping under a duplicate ack is version-dependent and
   * unspecified, so correctness must not depend on it tolerating one.
   *
   * `mode: 'drop'` skips the ack and is used ONLY where the CDP session is already detached or the page
   * is closed, where the ack would reject anyway.
   */
  releasePendingAck(entry: ScreencastEntry, mode: 'ack' | 'drop'): void {
    const pending = entry.pendingAck;
    if (!pending) return;
    clearTimeout(pending.timer);
    entry.pendingAck = null;
    if (mode === 'ack') this.ackFrame(entry, pending.sessionId);
  }

  // A failed ack is the primary stuck-stream signal (Chromium stops emitting after a few go unacked),
  // so it feeds THIS tab's health and schedules THIS tab's restart.
  private ackFrame(entry: ScreencastEntry, sessionId: number): void {
    entry.controller.ackScreencastFrame(sessionId).catch((err) => {
      log(`[Browser] Screencast frame ack failed: ${err instanceof Error ? err.message : String(err)}`);
      entry.health.noteAckFailure();
      this.scheduleAckRestart(entry);
    });
  }

  /**
   * The webview finished PAINTING a frame. Acking here (rather than on arrival) is the backpressure:
   * Chromium then produces at exactly the rate this panel can composite.
   *
   * A stale reply must never ack a newer frame, so this no-ops unless the id still matches — the frame
   * may have been superseded by a newer one, released on hide/resize, or already acked by the fallback.
   */
  onFrameRendered(entry: ScreencastEntry, frameId: number): void {
    if (entry.pendingAck?.frameId !== frameId) return;
    this.releasePendingAck(entry, 'ack');
  }

  onFrame(
    entry: ScreencastEntry,
    frame: { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number },
  ): void {
    // Each entry feeds its OWN health object: several panels can be visible and streaming at once.
    entry.health.noteFrame();
    this.resetBackoff(entry);

    // A hidden panel cannot receive posts at all, so the frame is worthless — ack it so Chromium keeps
    // its in-flight slot and drop it. Any frame still outstanding from before the hide goes with it.
    if (!entry.panel.visible) {
      this.releasePendingAck(entry, 'ack');
      this.ackFrame(entry, frame.sessionId);
      return;
    }

    // This frame supersedes any still-unpainted one; release the old ack so the in-flight count never
    // leaks, then take over.
    this.releasePendingAck(entry, 'ack');

    const bytes = Buffer.from(frame.data, 'base64');
    const frameId = entry.nextFrameId++;
    entry.lastFrame = { bytes, deviceWidth: frame.metadata.deviceWidth, deviceHeight: frame.metadata.deviceHeight };
    entry.panel.pushFrame(bytes, frame.metadata.deviceWidth, frame.metadata.deviceHeight, frameId);
    entry.pendingAck = {
      sessionId: frame.sessionId,
      frameId,
      timer: setTimeout(() => {
        log(`[Browser] Frame ${frameId} unacked after ${FRAME_ACK_FALLBACK_MS}ms — webview never reported it painted.`);
        this.releasePendingAck(entry, 'ack');
      }, FRAME_ACK_FALLBACK_MS),
    };
  }

  // A burst of ack failures on ONE tab collapses into a single restart of THAT tab's stream (the tab
  // whose ack failed is not necessarily the human-focused one). The debounce coalesces repeated
  // failures so Chromium is not hammered with concurrent restart calls while the stream is rebuilding.
  private scheduleAckRestart(entry: ScreencastEntry): void {
    if (entry.ackRestartTimer) return;
    entry.ackRestartTimer = setTimeout(() => {
      entry.ackRestartTimer = null;
      if (!this.isRegistered(entry) || !entry.panel.visible) return;
      this.start(entry).catch((err) =>
        log(`[Browser] Ack triggered screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, 500);
  }

  /**
   * Polls screencast health every {@link WATCHDOG_TICK_MS} and restarts stalled streams.
   *
   * EVERY entry is checked, not just the human-focused one: under split view several panels are
   * visible and streaming, and each carries its own health and backoff state.
   *
   * A wedged Chromium can fail every restart, so retries back off 5s→10s→20s→40s→60s (capped). The
   * backoff is counted in TICKS rather than wall-clock, because the watchdog can only ever act when a
   * tick fires: a millisecond deadline of `now + 5_000` is an exact multiple of the 5s interval, so it
   * lands on the very tick it is meant to permit and loses that race roughly half the time — which is
   * what made the first retry cost two ticks (C10: the observed 10s→10s→20s→40s). Skipping a counted
   * number of ticks is exact and immune to timer drift.
   *
   * The streak is NOT cleared just because a tick sees a healthy start window (each restart resets the
   * stall clock, which would falsely look healthy for a tick or two); only a frame actually arriving
   * (resetBackoff, from that entry's frame handler) proves recovery and clears it.
   */
  startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const connected = this.isConnected();
      for (const entry of this.entries()) {
        if (!entry.health.shouldRestart(now, entry.panel.visible, connected)) continue;
        if (entry.watchdogSkipTicks > 0) {
          entry.watchdogSkipTicks--;
          continue;
        }
        entry.watchdogFailureStreak++;
        const backoffMs = Math.min(WATCHDOG_TICK_MS * 2 ** (entry.watchdogFailureStreak - 1), WATCHDOG_MAX_BACKOFF_MS);
        entry.watchdogSkipTicks = backoffMs / WATCHDOG_TICK_MS - 1;
        this.start(entry).catch((err) =>
          log(`[Browser] Watchdog screencast restart failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }, WATCHDOG_TICK_MS);
  }

  resetBackoff(entry: ScreencastEntry): void {
    entry.watchdogFailureStreak = 0;
    entry.watchdogSkipTicks = 0;
  }

  /** Clears the interval and NOTHING else. Stopping the watchdog must not reset any entry's backoff
   *  streak: the streak lives on the entry precisely so it survives a stop, and resetting it here would
   *  let a user who tab-switches defeat the backoff entirely. Only a delivered frame
   *  ({@link ScreencastController.resetBackoff} from the frame handler) proves recovery. */
  clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** The watchdog only ever acts on a visible panel's stalled stream, so running it while every panel
   *  is hidden (or the browser is gone) is pure idle cost. Called from every place either input can
   *  change. */
  syncWatchdog(): void {
    const shouldRun = this.isConnected() && [...this.entries()].some((e) => e.panel.visible);
    if (shouldRun) {
      if (!this.watchdogTimer) this.startWatchdog();
      return;
    }
    this.clearWatchdog();
  }
}
