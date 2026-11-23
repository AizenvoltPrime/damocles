// Screenshots of the window for ThemeRead (docs/invariants.md "Desktop themes"): in main's memory only, under unguessable random
// ids, served at app://damocles/theme-shot/<id>, dropped when their card closes or SCREENSHOT_TTL_MS pass, never written.
import { randomBytes } from 'node:crypto';
import { SCREENSHOT_ANSWER_MS } from '../../../shared/themes/agent';
import { THEME_SHOT_ID } from '../../../shared/themes/wallpapers';

// Past the card's own wait, so a screenshot goes under an open card only when its core is gone.
export const SCREENSHOT_TTL_MS: number = SCREENSHOT_ANSWER_MS + 60_000;
// at most this many wait for their card at once; the oldest goes first
export const MAX_SCREENSHOTS = 8;
export const SHOT_ID: RegExp = THEME_SHOT_ID;

interface Shot {
  readonly png: Uint8Array;
  readonly timer: unknown;
}

export interface ScreenshotStoreDeps {
  // a screenshot left to make room for a newer one while its card may still show it
  evicted?(id: string): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class ScreenshotStore {
  private readonly shots = new Map<string, Shot>();
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly evicted: ((id: string) => void) | undefined;

  constructor(deps: ScreenshotStoreDeps = {}) {
    this.evicted = deps.evicted;
    this.setTimer = deps.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return timer;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Keeps `png` under a new id until it is dropped or expires. */
  put(png: Uint8Array): string {
    while (this.shots.size >= MAX_SCREENSHOTS) {
      const oldest = this.shots.keys().next().value!;
      this.drop(oldest);
      this.evicted?.(oldest);
    }
    const id = randomBytes(16).toString('hex');
    this.shots.set(id, { png, timer: this.setTimer(() => this.drop(id), SCREENSHOT_TTL_MS) });
    return id;
  }

  get(id: string): Uint8Array | undefined {
    return SHOT_ID.test(id) ? this.shots.get(id)?.png : undefined;
  }

  drop(id: string): void {
    const shot = this.shots.get(id);
    if (!shot) return;
    this.clearTimer(shot.timer);
    this.shots.delete(id);
  }

  size(): number {
    return this.shots.size;
  }

  dispose(): void {
    for (const id of [...this.shots.keys()]) this.drop(id);
  }
}
