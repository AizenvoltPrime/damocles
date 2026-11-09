import type { DesignCapture, DesignJourneyRun, DesignProbeResult, JourneyStep } from '../shared/types/design';

/** The desktop preview, which only desktop has; its renders run in the attached client's own runner (PD-11, PD-41). */
export interface DesignPreviewHost {
  /**
   * Opens or shows the preview tab of `relPath` ('/' separated, below the design folder) in design chat `panelId`; false when
   * no app it may open in shows the chat (inside a device's work, only that device's).
   */
  open(panelId: string, designId: string, relPath: string): Promise<boolean>;
  /** Files of design `designId` changed, '/' separated below its folder, so its open previews reload. */
  changed(designId: string, paths: readonly string[]): void;
  /**
   * A PNG of screen `relPath` at `width` CSS px in `state` (null: default), at most `scale` device px per CSS px. Rejects with
   * DESIGN_RENDER_CLIENT_ABSENT's text while no client that renders designs is attached.
   */
  capture(designId: string, relPath: string, width: number, state: string | null, scale: number, signal: AbortSignal): Promise<DesignCapture>;
  /** Screen `relPath` measured at each width, and with `sweepTo` the overflow sweep up to it; refuses as `capture` does. */
  probe(designId: string, relPath: string, widths: readonly number[], state: string | null, sweepTo: number | undefined, signal: AbortSignal): Promise<DesignProbeResult>;
  /** The journey's steps on screen `relPath` in a fresh page at each width; with `outline`, each page's DOM outline; refuses as `capture` does. */
  journey(designId: string, relPath: string, widths: readonly number[], state: string | null, steps: readonly JourneyStep[], outline: boolean, signal: AbortSignal): Promise<DesignJourneyRun>;
  /** Replays the steps in the live preview tab of `relPath` in design chat `panelId`, which it opens or shows; resolves once the replay ended. */
  replayJourney(panelId: string, designId: string, relPath: string, state: string | null, steps: readonly JourneyStep[], reducedMotion: boolean, signal: AbortSignal): Promise<void>;
}
