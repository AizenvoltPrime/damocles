import type { Page } from '@playwright/test';

/** One animation frame of a Chats row: its worktree status and the rendered size of each provider logo in it. */
export interface ChatRowFrame {
  readonly t: number;
  // data-worktree; null for a row without a worktree
  readonly worktree: string | null;
  readonly logos: ReadonlyArray<{ readonly width: number; readonly height: number }>;
}

interface Recorder {
  frames: ChatRowFrame[];
  stop: boolean;
}

declare global {
  interface Window {
    __chatRowFrames?: Recorder;
  }
}

/** Starts recording, every animation frame until `chatRowFrames`, the Chats row titled `title`, or the selected row. */
export async function recordChatRow(shell: Page, title: string | 'selected'): Promise<void> {
  await shell.evaluate((title) => {
    const recorder: Recorder = { frames: [], stop: false };
    window.__chatRowFrames = recorder;
    const start = performance.now();
    const tick = (): void => {
      if (recorder.stop) return;
      const row = [...document.querySelectorAll('[data-testid="chat-list"] [role="option"]')]
        .find((option) => (title === 'selected' ? option.getAttribute('aria-selected') === 'true' : option.querySelector('[data-testid="chat-title"]')?.textContent === title));
      if (row) {
        const logos = [...row.querySelectorAll('[data-testid="provider-logo"] > svg')].map((svg) => {
          const box = svg.getBoundingClientRect();
          return { width: box.width, height: box.height };
        });
        recorder.frames.push({ t: Math.round(performance.now() - start), worktree: row.getAttribute('data-worktree'), logos });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, title);
}

/** Stops the recording `recordChatRow` started and returns its frames. */
export async function chatRowFrames(shell: Page): Promise<ChatRowFrame[]> {
  return shell.evaluate(() => {
    const recorder = window.__chatRowFrames!;
    recorder.stop = true;
    return recorder.frames;
  });
}

/** The largest side any provider logo rendered at over the frames; 0 when none showed. */
export function largestLogo(frames: readonly ChatRowFrame[]): number {
  return Math.max(0, ...frames.flatMap((frame) => frame.logos.map((logo) => Math.max(logo.width, logo.height))));
}
