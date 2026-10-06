import type { NativeImage } from 'electron';
import { badgeLabel } from './notification-art';

// Count changes within one frame apply once.
export const COUNTER_FRAME_MS = 16;

export interface TaskbarWindow {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: NativeImage | null, description: string): void;
}

export interface TaskbarCounterDeps {
  readonly platform: NodeJS.Platform;
  readonly window: () => TaskbarWindow | undefined;
  readonly badge: (label: string) => Promise<NativeImage>;
  // app.setBadgeCount: the macOS dock and the Linux launcher (LauncherEntry); false when the OS did not take it
  readonly setBadgeCount: (count: number) => boolean;
  // the overlay icon's accessible description, e.g. "4 new notifications"
  readonly describe: (count: number) => string;
  readonly log: (line: string) => void;
}

/** The bell's unseen count on the taskbar button (D52): a drawn overlay badge on Windows, the app badge elsewhere. */
export class TaskbarCounter {
  private readonly deps: TaskbarCounterDeps;
  private wanted = 0;
  // the count last shown, or last tried when showing it failed
  private applied: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refusalLogged = false;

  constructor(deps: TaskbarCounterDeps) {
    this.deps = deps;
  }

  update(count: number): void {
    this.wanted = Math.max(0, count);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.apply().catch((err: unknown) => {
        this.deps.log(`[notifications] could not show the unread count on the taskbar: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, COUNTER_FRAME_MS);
  }

  /** Shows the count again: for a new window, a new UI language, a new display scale or an overlay page that can draw now. */
  reapply(): void {
    this.applied = undefined;
    this.update(this.wanted);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async apply(): Promise<void> {
    const count = this.wanted;
    if (count === this.applied) return;
    // A failure is not retried for the same count; the next count or reapply tries again.
    this.applied = count;
    if (this.deps.platform !== 'win32') {
      if (!this.deps.setBadgeCount(count) && !this.refusalLogged) {
        this.refusalLogged = true;
        this.deps.log('[notifications] the OS did not take the app badge count, so only the bell shows it');
      }
      return;
    }
    const image = count === 0 ? null : await this.deps.badge(badgeLabel(count));
    // A later count is on its way; the badge drawn for this one is stale.
    if (count !== this.wanted) return;
    const window = this.deps.window();
    if (!window || window.isDestroyed()) {
      this.applied = undefined;
      return;
    }
    window.setOverlayIcon(image, image ? this.deps.describe(count) : '');
  }
}
