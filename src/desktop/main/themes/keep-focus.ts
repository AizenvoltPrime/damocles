// Keyboard focus on the keep-changes banner (docs/invariants.md "Desktop themes"): the banner's buttons go when its countdown
// ends, so focus that F6 moved onto them returns to the part it came from, as the desktop popups give theirs back.
export class KeepFocus<Part> {
  private origin: Part | undefined;

  /** F6 moved focus onto the banner from `from`. */
  entered(from: Part): void {
    this.origin = from;
  }

  /** Focus is somewhere other than the banner. */
  left(): void {
    this.origin = undefined;
  }

  /** The countdown ended: the part focus goes to when it is still on the banner, `fallback` when a click or Tab put it there. */
  ended(onBanner: boolean, fallback: Part): Part | undefined {
    const origin = this.origin;
    this.origin = undefined;
    return onBanner ? origin ?? fallback : undefined;
  }
}
