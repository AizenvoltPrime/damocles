import type { ElectronApplication, Page } from '@playwright/test';

/** One animation frame of a chat page: which of the composer's three states it rendered. */
export interface ComposerFrame {
  readonly t: number;
  // the normal composer
  readonly composer: boolean;
  // the same-height placeholder a resuming chat shows until it knows its place
  readonly placeholder: boolean;
  // "This chat's worktree was deleted"
  readonly deleted: boolean;
}

interface Recorder {
  frames: ComposerFrame[];
  stop: boolean;
}

declare global {
  interface Window {
    __composerFrames?: Recorder;
  }
}

/**
 * Records, from the first animation frame of every chat page created from now on, what its composer area renders, so a
 * page that loads after this call is seen before its first paint, not after Playwright found it.
 */
export async function recordComposerFrames(app: ElectronApplication): Promise<void> {
  await app.context().addInitScript(() => {
    if (!location.pathname.includes('/panel/')) return;
    const recorder: Recorder = { frames: [], stop: false };
    window.__composerFrames = recorder;
    const start = performance.now();
    const tick = (): void => {
      if (recorder.stop) return;
      recorder.frames.push({
        t: Math.round(performance.now() - start),
        composer: document.querySelector('[data-testid="composer"]') !== null,
        placeholder: document.querySelector('[data-testid="composer-placeholder"]') !== null,
        deleted: document.querySelector('[data-testid="worktree-deleted"]') !== null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Stops the chat page's recording and returns its frames; empty when the page started before recordComposerFrames. */
export async function composerFrames(tab: Page): Promise<ComposerFrame[]> {
  return tab.evaluate(() => {
    const recorder = window.__composerFrames;
    if (!recorder) return [];
    recorder.stop = true;
    return recorder.frames;
  });
}
