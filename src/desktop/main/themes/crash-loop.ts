// The theme crash loop (docs/invariants.md "Desktop themes"): the shell page or a chat page crashing CRASH_LOOP_LIMIT times
// within CRASH_LOOP_WINDOW_MS while a custom look shows switches the run to safe start. Pure: the caller passes the clock.
export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_LIMIT = 2;

export class ThemeCrashLoop {
  private crashes: number[] = [];
  private tripped = false;

  /**
   * One renderer crash at `now`; `customShown` is whether a look other than the built-in one showed. True exactly once: on
   * the crash that makes CRASH_LOOP_LIMIT within the window, which switches to safe start. A crash under the built-in look
   * counts nothing, and neither does one after the switch.
   */
  crashed(now: number, customShown: boolean): boolean {
    if (this.tripped || !customShown) return false;
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_LOOP_WINDOW_MS), now];
    if (this.crashes.length < CRASH_LOOP_LIMIT) return false;
    this.tripped = true;
    return true;
  }

  /** "Use my theme" tries the theme again, so the count starts over. */
  reset(): void {
    this.crashes = [];
    this.tripped = false;
  }
}
